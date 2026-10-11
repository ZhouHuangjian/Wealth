# Mac 一键启动

在项目目录双击 **启动相知.command**。首次运行会检查依赖并构建；需要安装依赖时会运行项目锁文件对应的 `npm ci`，因此需要网络。安装 Node.js 22.13 或更新版本后即可使用；启动入口会寻找 Apple Silicon / Intel Homebrew 的 Node，以及当前 PATH 中可用的 Node。也可在启动前设置 `XIANZHI_NODE_BIN` 指向 Node 可执行文件。

成功后浏览器打开工作台，可以关闭终端窗口。再次双击会复用经过身份核对的本目录服务，不重复启动。源码未变化且构建缓存完整时跳过构建。正在运行时不会自动替换前端文件或重启；更新源码后，先停止再启动以应用更新。

默认地址为 `http://127.0.0.1:4351/`。配置优先顺序是当前启动环境、项目 `.env`、启动器默认值；路径以项目目录为基准，支持空格和中文。`.env` 按 Node 的 dotenv 格式读取，不作为 shell 脚本执行。

- `PORT`：显式设置时沿用，否则为 `4351`。
- `DATA_DIR`：显式设置时沿用；否则优先已有的 `private/wechat-pilot/xiangzhi.sqlite`，没有时使用 `private/xiangzhi.sqlite`。原数据库旁的 `.draft-sync` 私有目录保持原位置，已保存的云端绑定会继续使用。
- `PROFILE_MANIFEST_PATH`：保留显式配置；未设置时沿用已有的 `private/learning/2026-10-10-v1/current-profile.json`。不复制或创建个人档案。
- 模型、微信工具及同步环境配置继续沿用；没有显式 Codex 路径时可识别本机 ChatGPT 应用附带的 CLI，不读取或复制登录凭据。
- 启动器固定使用生产模式和 `SEED_DEMO=false`，不会创建演示聊天。服务启动后，已有微信读取与自动回复开关仍按系统规则暂停；保留“生成后同步”偏好，但不会上传旧草稿、执行连接验证或自动生成新回复。

双击 **停止相知.command** 可停止本启动器创建的后台服务。原来通过开发终端启动的服务可以复用，但必须通过原方式停止。启动器不会仅凭端口的健康响应认领或终止进程；会核对监听进程、工作目录、程序入口、打开的 SQLite 文件，停止时还核对本次启动身份。端口被其他程序或另一数据实例占用时会显示错误，不自动杀进程。同一数据库也不能同时从另一个端口启动；启动期间的数据目录锁会协调重复点击。

命令行也可在项目目录使用：

```sh
node scripts/launcher.mjs start
node scripts/launcher.mjs start --no-open
node scripts/launcher.mjs status
node scripts/launcher.mjs stop
```

日志与运行记录只保存在忽略入库的 `private/launcher/`，目录权限为 `0700`，日志和状态文件为 `0600`。`service-端口.log` 是服务日志，`setup.log` 是依赖安装和构建日志。数据目录旁的 `.xiangzhi-launch.sqlite` 仅用作跨进程启动锁，不包含聊天或凭据；进程退出后锁自动释放，无需手工清理。日志对环境中的凭据做脱敏；不会打印 `.env` 或设备配置包。遇到首次依赖安装失败，检查网络后重新双击；构建失败则查看 `setup.log`。启动器不会安装或升级系统 Node，也不会修改 SIP、微信或系统安全设置。
