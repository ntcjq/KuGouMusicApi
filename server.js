const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson, randomNumber, randomString } = require('./util/util');
const { createRequest } = require('./util/request');
const dotenv = require('dotenv');
const cache = require('./util/apicache').middleware;
const cron = require('node-cron');

/**
 * @typedef {{
 * identifier?: string,
 * route: string,
 * module: any,
 * }}ModuleDefinition
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

const mid = randomNumber(39).toString();
const serverDev = randomString(10).toUpperCase();

// 内存存储登录信息和定时任务状态
const loginStore = {};
const cronJobs = {};

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

/**
 *  描述：动态获取模块定义
 * @param {string}  modulesPath  模块路径(TS)
 * @param {Record<string, string>} specificRoute  特定模块定义
 * @param {boolean} doRequire  如果为 true，则使用 require 加载模块, 否则打印模块路径， 默认为true
 * @return { Promise<ModuleDefinition[]> }
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(modulesPath, specificRoute, doRequire = true) {
  const files = await fs.promises.readdir(modulesPath);
  const parseRoute = (fileName) =>
    specificRoute && fileName in specificRoute ? specificRoute[fileName] : `/${fileName.replace(/\.(js)$/i, '').replace(/_/g, '/')}`;

  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const identifier = fileName.split('.').shift();
      const route = parseRoute(fileName);
      const modulePath = path.resolve(modulesPath, fileName);
      const module = doRequire ? require(modulePath) : modulePath;
      return { identifier, route, module };
    });
}

/**
 * 创建服务
 * @param {ModuleDefinition[]} moduleDefs
 * @return {Promise<import('express').Express>}
 */
async function consturctServer(moduleDefs) {
  const app = express();
  const { CORS_ALLOW_ORIGIN } = process.env;
  app.set('trust proxy', true);

  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Authorization,X-Requested-With,Content-Type,Cache-Control',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  // Cookie Parser
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) {
        return;
      }
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  // 将当前平台写入Cookie 以方便查看
  app.use((req, res, next) => {
    const cookieArr = (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g);
    let cookies = {};
    cookieArr.forEach((i) => {
      let arr = i.split('=');
      cookies[arr[0]] = arr[1];
    });

    if (!cookies.hasOwnProperty('KUGOU_API_PLATFORM')) {
      if (req.protocol === 'https') {
        res.append('Set-Cookie', `KUGOU_API_PLATFORM=${process.env.platform}; PATH=/; SameSite=None; Secure`);
      } else {
        res.append('Set-Cookie', `KUGOU_API_PLATFORM=${process.env.platform}; PATH=/`);
      }
    }

    if (req.protocol === 'https') {
      if (!cookies.hasOwnProperty('KUGOU_API_MID'))
        res.append('Set-Cookie', `KUGOU_API_MID=${process.env.KUGOU_API_MID ?? mid}; PATH=/; SameSite=None; Secure`);
      if (!cookies.hasOwnProperty('KUGOU_API_DEV'))
        res.append('Set-Cookie', `KUGOU_API_DEV=${(process.env.KUGOU_API_DEV ?? serverDev).toUpperCase()}; PATH=/; SameSite=None; Secure`);
    } else {
      if (!cookies.hasOwnProperty('KUGOU_API_MID')) res.append('Set-Cookie', `KUGOU_API_MID=${process.env.KUGOU_API_MID ?? mid}; PATH=/`);
      if (!cookies.hasOwnProperty('KUGOU_API_DEV'))
        res.append('Set-Cookie', `KUGOU_API_DEV=${(process.env.KUGOU_API_DEV ?? serverDev).toUpperCase()}; PATH=/`);
    }

    next();
  });

  // Body Parser
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * docs
   */

  app.use('/docs', express.static(path.join(__dirname, 'docs')));

  // Cache
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200));

  /**
   * 登录信息管理 API
   */
  // 保存登录信息到内存
  app.post('/api/saveLogin', express.json(), (req, res) => {
    const { userid, token } = req.body;
    if (!userid || !token) {
      return res.json({ status: 0, msg: '缺少userid或token' });
    }
    
    loginStore[userid] = { userid, token, savedAt: new Date() };
    console.log(`[Login] 保存登录信息: userid=${userid}`);
    res.json({ status: 1, msg: '登录信息已保存到服务器内存' });
  });

  // 获取所有已保存的登录信息
  app.get('/api/getLogins', (req, res) => {
    const logins = Object.values(loginStore).map(item => ({
      userid: item.userid,
      token: item.token,
      savedAt: item.savedAt
    }));
    res.json({ status: 1, data: logins });
  });

  // 删除登录信息
  app.post('/api/deleteLogin', express.json(), (req, res) => {
    const { userid } = req.body;
    if (!userid) {
      return res.json({ status: 0, msg: '缺少userid' });
    }
    
    delete loginStore[userid];
    console.log(`[Login] 删除登录信息: userid=${userid}`);
    res.json({ status: 1, msg: '登录信息已删除' });
  });

  // 清空所有登录信息
  app.post('/api/clearLogins', (req, res) => {
    Object.keys(loginStore).forEach(key => delete loginStore[key]);
    console.log('[Login] 已清空所有登录信息');
    res.json({ status: 1, msg: '所有登录信息已清空' });
  });

  // 获取定时任务状态
  app.get('/api/getCronStatus', (req, res) => {
    const status = {};
    for (const userid in cronJobs) {
      status[userid] = cronJobs[userid].running ? '运行中' : '已停止';
    }
    res.json({ status: 1, data: status });
  });

  /**
   * 定时签到 API
   */
  app.post('/api/startAutoCron', express.json(), async (req, res) => {
    const { userid, time = '0 2 * * *' } = req.body;
    
    if (!userid || !loginStore[userid]) {
      return res.json({ status: 0, msg: '用户不存在或未登录' });
    }

    // 如果已有定时任务则停止
    if (cronJobs[userid]) {
      cronJobs[userid].stop();
      delete cronJobs[userid];
    }

    const token = loginStore[userid].token;
    const headers = { 'Cookie': `token=${token}; userid=${userid}` };

    const job = cron.schedule(time, async () => {
      console.log(`[Cron] 开始自动签到: userid=${userid}`);
      try {
        // 获取用户信息
        const userRes = await createRequest({
          url: 'http://localhost:3000/user/detail',
          headers: headers
        });
        const userDetail = JSON.parse(userRes);

        if (!userDetail?.data?.nickname) {
          console.log(`[Cron] token过期: userid=${userid}`);
          return;
        }

        console.log(`[Cron] 用户 ${userDetail.data.nickname} 开始签到`);

        // 听歌领取VIP
        const listenRes = await createRequest({
          url: 'http://localhost:3000/youth/listen/song',
          headers: headers
        });
        const listen = JSON.parse(listenRes);
        console.log(`[Cron] 听歌结果: ${listen.status === 1 ? '成功' : '失败/已领取'}`);

        // 领取VIP（循环8次）
        for (let i = 1; i <= 8; i++) {
          const adRes = await createRequest({
            url: 'http://localhost:3000/youth/vip',
            headers: headers
          });
          const ad = JSON.parse(adRes);

          if (ad.status === 1) {
            console.log(`[Cron] 第${i}次领取成功`);
            if (i !== 8) {
              const randomDelay = 30000 + Math.random() * 10000; // 随机30-40秒
              console.log(`[Cron] 等待${(randomDelay/1000).toFixed(1)}秒后继续...`);
              await new Promise(resolve => setTimeout(resolve, randomDelay));
            }
          } else if (ad.error_code === 30002) {
            console.log(`[Cron] 今日次数已用光`);
            break;
          } else {
            console.log(`[Cron] 第${i}次领取失败`);
            break;
          }
        }

        // 获取VIP详情
        const vipRes = await createRequest({
          url: 'http://localhost:3000/user/vip/detail',
          headers: headers
        });
        const vip = JSON.parse(vipRes);
        if (vip.status === 1) {
          console.log(`[Cron] VIP到期时间: ${vip.data.busi_vip[0].vip_end_time}`);
        }
      } catch (error) {
        console.error(`[Cron] 签到出错: ${error.message}`);
      }
    });

    cronJobs[userid] = job;
    console.log(`[Cron] 已为用户 ${userid} 创建定时任务，执行时间: ${time}`);
    res.json({ status: 1, msg: `定时任务已创建，执行时间: ${time}` });
  });

  app.post('/api/stopAutoCron', express.json(), (req, res) => {
    const { userid } = req.body;
    
    if (!cronJobs[userid]) {
      return res.json({ status: 0, msg: '未找到该用户的定时任务' });
    }

    cronJobs[userid].stop();
    delete cronJobs[userid];
    console.log(`[Cron] 已停止用户 ${userid} 的定时任务`);
    res.json({ status: 1, msg: '定时任务已停止' });
  });

  const moduleDefinitions = moduleDefs || (await getModulesDefinitions(path.join(__dirname, 'module'), {}));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      const { cookie, ...params } = req.query;

      const query = Object.assign({}, { cookie: Object.assign({}, req.cookies, cookie) }, params, { body: req.body });

      const authHeader = req.headers['authorization'];
      if (authHeader) {
        query.cookie = {
          ...query.cookie,
          ...cookieToJson(authHeader),
        };
      }
      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip.substring(0, 7) === '::ffff:') {
            ip = ip.substring(7);
          }
          config.ip = ip;
          return createRequest(config);
        });

        console.log('[OK]', decode(req.originalUrl));

        const cookies = moduleResponse.cookie;
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/; SameSite=None; Secure`;
                })
              );
            } else {
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/`;
                })
              );
            }
          }
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        const moduleResponse = e;
        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        });

        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          });
          return;
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      }
    });
  }

  return app;
}

/**
 * Serve the KG API
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function startService() {
  const port = Number(process.env.PORT || '3000');
  const host = process.env.HOST || '';

  const app = await consturctServer();

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app;

  appExt.service = app.listen(port, host, () => {
    console.log(`server running @ http://${host || 'localhost'}:${port}`);
  });

  return appExt;
}

module.exports = { startService, getModulesDefinitions };
