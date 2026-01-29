FROM node:lts-alpine

RUN apk add --no-cache tini

# 全局安装 pnpm
RUN npm install -g pnpm

ENV NODE_ENV=production

USER node

WORKDIR /app

COPY --chown=node:node . ./

# 使用 pnpm 安装依赖
RUN pnpm install --no-frozen-lockfile

EXPOSE 3000

CMD [ "/sbin/tini", "--", "node", "app.js" ]