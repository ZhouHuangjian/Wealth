import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { createApplication } from './app.js';

const port=Number(process.env.PORT??4317);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('PORT 必须是 1024 至 65535 之间的端口。');
const profileManifestPath=process.env.PROFILE_MANIFEST_PATH?.trim();
const instance=createApplication({
  databasePath:resolve(process.env.DATA_DIR??'private','xiangzhi.sqlite'),
  seed:process.env.SEED_DEMO!=='false',
  profileManifestPath:profileManifestPath ? resolve(profileManifestPath) : undefined,
});
const server=createServer(instance.app);
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if(process.env.NODE_ENV==='production') {
  const index=resolve('dist/index.html');
  if(!existsSync(index)) throw new Error('请先运行 npm run build。');
  instance.app.use(express.static(resolve('dist')));
  instance.app.use((_req,res)=>res.sendFile(index));
} else {
  const {createServer:createViteServer}=await import('vite');
  vite=await createViteServer({server:{middlewareMode:true,hmr:{server}},appType:'spa'});
  instance.app.use(vite.middlewares);
}
server.on('error',(error)=>{console.error('无法启动本机服务：',error.message);process.exitCode=1;instance.close();});
server.listen(port,'127.0.0.1',()=>{instance.engine.start();instance.collector.start();instance.remote.start();instance.mediaAutomation.start();instance.insights.start();console.log(`相知已启动：http://127.0.0.1:${port} · 自动回复默认关闭`);});
let closing=false;
async function shutdown(){if(closing)return;closing=true;instance.insights.stop();instance.mediaAutomation.stop();instance.remote.stop();instance.collector.stop();instance.engine.pause();instance.engine.stop();await instance.engine.tick().catch(()=>{});await vite?.close();server.close(()=>{instance.store.close();process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
