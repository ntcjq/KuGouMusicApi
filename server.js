const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson, randomNumber, randomString } = require('./util/util');
const { createRequest } = require('./util/request');
const dotenv = require('dotenv');
const apicache = require('./util/apicache');
const cache = apicache.middleware;
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
    const start = process.hrtime.bigint();
    const { userid, token } = req.body;
    if (!userid || !token) {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      res.set('X-Elapsed-Ms', String(elapsedMs.toFixed(3)));
      return res.json({ status: 0, msg: '缺少userid或token' });
    }
    
    loginStore[userid] = { userid, token, savedAt: new Date() };
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[Login] 保存登录信息: userid=${userid} (elapsed: ${elapsedMs.toFixed(3)}ms)`);

    // 清理缓存，确保 /api/getLogins 立刻返回最新数据
    try {
      apicache.clear();
      console.log('[Cache] apicache cleared after saveLogin');
    } catch (e) {
      console.warn('[Cache] 清理缓存失败:', e.message);
    }

    // 调试：打印完整的 loginStore 及当前进程PID
    try {
      console.log('[Login] 当前 loginStore:', JSON.stringify(loginStore));
    } catch (e) {
      console.log('[Login] 当前 loginStore (stringify failed)');
    }
    console.log(`[Login] 处理进程 PID: ${process.pid}`);
    // 返回时带上耗时和进程ID，便于前端比对
    res.set('X-Elapsed-Ms', String(elapsedMs.toFixed(3)));
    res.set('X-PID', String(process.pid));
    res.json({ status: 1, msg: '登录信息已保存到服务器内存', elapsedMs, pid: process.pid });
  });

  // 获取所有已保存的登录信息
  app.get('/api/getLogins', (req, res) => {
    const start = process.hrtime.bigint();
    const logins = Object.values(loginStore).map(item => ({
      userid: item.userid,
      token: item.token,
      savedAt: item.savedAt
    }));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[Login] 返回登录列表 (count=${logins.length}, elapsed: ${elapsedMs.toFixed(3)}ms)`);
    // 调试：打印当前 loginStore 与处理进程 PID
    try {
      console.log('[Login] 当前 loginStore:', JSON.stringify(loginStore));
    } catch (e) {
      console.log('[Login] 当前 loginStore (stringify failed)');
    }
    console.log(`[Login] 处理进程 PID: ${process.pid}`);

    res.set('X-Elapsed-Ms', String(elapsedMs.toFixed(3)));
    res.set('X-PID', String(process.pid));
    res.json({ status: 1, data: logins, elapsedMs, pid: process.pid });
  });

  // 手动清除缓存（支持可选 body.target 来只清除包含该路径的缓存 key）
  app.post('/api/clearCache', express.json(), (req, res) => {
    const { target } = req.body || {};
    try {
      const idx = apicache.getIndex();
      const allKeys = (idx && idx.all) || [];
      if (!target) {
        apicache.clear();
        console.log('[Cache] 全部缓存已被清除 (manual)');
        return res.json({ status: 1, msg: '已清空所有缓存', cleared: 'all' });
      }

      const keys = allKeys.filter(k => k.includes(target));
      keys.forEach(k => {
        apicache.clear(k);
        console.log('[Cache] cleared key', k);
      });
      res.json({ status: 1, msg: `已清除 ${keys.length} 条缓存`, keys });
    } catch (e) {
      console.error('[Cache] 清除缓存失败:', e);
      res.json({ status: 0, msg: e.message });
    }
  });

  // 删除登录信息
  app.post('/api/deleteLogin', express.json(), (req, res) => {
    const { userid } = req.body;
    if (!userid) {
      return res.json({ status: 0, msg: '缺少userid' });
    }
    
    delete loginStore[userid];
    console.log(`[Login] 删除登录信息: userid=${userid}`);
    try {
      apicache.clear();
      console.log('[Cache] apicache cleared after deleteLogin');
    } catch (e) {
      console.warn('[Cache] 清理缓存失败:', e.message);
    }
    res.json({ status: 1, msg: '登录信息已删除' });
  });

  // 清空所有登录信息
  app.post('/api/clearLogins', (req, res) => {
    Object.keys(loginStore).forEach(key => delete loginStore[key]);
    console.log('[Login] 已清空所有登录信息');
    try {
      apicache.clear();
      console.log('[Cache] apicache cleared after clearAllLogins');
    } catch (e) {
      console.warn('[Cache] 清理缓存失败:', e.message);
    }
    res.json({ status: 1, msg: '所有登录信息已清空' });
  });

  // 获取定时任务状态
  app.get('/api/getCronStatus', (req, res) => {
    const status = {};
    for (const userid in cronJobs) {
      const job = cronJobs[userid];
      // node-cron v4 的任务对象将运行状态放在 runner.running 中，做兼容性判断
      const isRunning = !!(job && ((job.runner && job.runner.running) || job.stateMachine?.state === 'scheduled'));
      status[userid] = isRunning ? '运行中' : '已停止';
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

    // 调试：打印任务创建后的 runner 状态，便于排查“已停止”问题
    console.log(`[Cron] 任务创建后 runner.running: ${job.runner ? job.runner.running : 'unknown'}`);

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

  // 调试接口：返回原始 loginStore（包含 token），便于排查为何列表为空
  app.get('/api/debugLogins', (req, res) => {
    try {
      console.log('[Debug] /api/debugLogins 被调用');
      console.log('[Debug] loginStore Snapshot:', JSON.stringify(loginStore));
    } catch (e) {
      console.log('[Debug] loginStore stringify failed');
    }
    res.json({ status: 1, data: loginStore, pid: process.pid });
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
