# 快速开始

## 1. 安装插件

在终端执行：

```sh
dsh plugin --profile web add dsh-traffic-light
```

如果 DSH 当前已经使用 `web` profile，可以使用简写：

```sh
dsh plugin add dsh-traffic-light
```

首次安装会下载桌面悬浮窗所需的运行组件，请等待命令完成。

## 2. 启动或重启 DSH Web

```sh
dsh web
```

如果 DSH Web 已经在运行，请先退出当前实例，再重新执行上面的命令，让插件菜单加载完成。

## 3. 开启一个 Session 的悬浮灯

1. 在 DSH 页面打开目标 Session。
2. 点击 Session 行右侧的三点菜单。
3. 选择「开启红绿灯」。
4. 桌面出现悬浮灯后，可以把它拖到合适的位置。

每个 Session 都有自己的开关。要监控多个 Session，只需分别在各自菜单中开启。

## 4. 关闭一个 Session 的悬浮灯

关闭当前 Session 的悬浮灯，不会影响其他 Session：

- 在 Session 三点菜单中选择「关闭红绿灯」；或
- 在悬浮灯上右键，在菜单中选择「关闭悬浮灯」。

右键后需要选择菜单项才会关闭，普通左键不会关闭悬浮灯。

## 5. 确认状态

| 灯光 | 状态 | 说明 |
| --- | --- | --- |
| 黄灯慢呼吸 | 运行中 | Session 正在处理任务。 |
| 黄灯快闪 | 需要关注 | 等待确认、回答，或任务暂时受阻。 |
| 绿灯 | 已完成 | 本轮任务正常完成。 |
| 红灯 | 失败 | 本轮任务发生错误或异常中断。 |
| 熄灭 | 空闲 | 当前没有正在执行的任务。 |

## 更新插件

如果 DSH 的插件 CLI 支持更新命令，可以执行：

```sh
dsh plugin --profile web update dsh-traffic-light
```

如果当前版本不支持 `update`，使用卸载后重新安装：

```sh
dsh plugin --profile web remove dsh-traffic-light
dsh plugin --profile web add dsh-traffic-light
```

更新后重新启动 `dsh web`。

## 卸载插件

```sh
dsh plugin --profile web remove dsh-traffic-light
```

然后重新启动 `dsh web`。插件退出后，已打开的悬浮灯会自动关闭。

## 排查问题

### 菜单没有开关

确认安装命令使用的是 `web` profile，并完全重启 `dsh web`。只刷新网页通常不够。

### 开启后没有悬浮灯

等待首次运行组件准备完成；仍未出现时，重启 DSH Web，再从该 Session 的三点菜单重新开启。

### 灯光更新慢或停留在旧状态

确认 DSH Web 仍在运行，并且操作的是同一个 Session。可以先在 Session 菜单关闭，再重新开启悬浮灯；如果仍然没有更新，重启 `dsh web`。

### 关闭后页面开关没有同步

等待页面同步，或刷新 DSH 页面。如果仍显示开启，重启 `dsh web` 后再查看该 Session 菜单。

### 需要查看网页状态吗

插件的主要界面是桌面悬浮灯，不是网页 Dashboard。网页状态页只适合排查问题，日常使用无需打开它。

