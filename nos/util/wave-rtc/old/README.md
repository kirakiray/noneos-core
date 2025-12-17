# WaveRTC - 基于声波通信的WebRTC库

WaveRTC是一个创新的库，它允许在局域网内的设备通过声波交换WebRTC连接信息，从而建立点对点连接。这使得设备可以在没有传统信令服务器的情况下建立直接通信。

## 特性

- 通过声波交换WebRTC连接信息（SDP和ICE候选）
- 支持数据通道通信
- 易于使用的API
- 基于现有的ggwave声波通信库
- 适用于局域网环境

## 安装

该库已集成到NoneOS项目中，无需额外安装。

## 使用方法

### 基本用法

```javascript
import WaveRTC from './packages/util/wave-rtc/main.js';

// 创建WaveRTC实例
const waveRTC = new WaveRTC();

// 初始化连接（发起方）
await waveRTC.init(true); // true表示发起方

// 初始化连接（接收方）
await waveRTC.init(false); // false表示接收方

// 监听连接事件
waveRTC.addEventListener('connected', () => {
  console.log('连接已建立');
});

// 发送消息
waveRTC.sendMessage('Hello, World!');

// 接收消息
waveRTC.addEventListener('data', (event) => {
  console.log('收到消息:', event.detail.message);
});

// 关闭连接
await waveRTC.close();
```

### 配置选项

```javascript
const waveRTC = new WaveRTC({
  // 自定义STUN服务器
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // 添加更多STUN/TURN服务器
  ],
  
  // ggwave配置
  ggwave: {
    volume: 0.8 // 声波音量 (0.0 - 1.0)
  }
});
```

## 示例

查看 `example.html` 文件了解完整的使用示例。

## 工作原理

1. **角色分配**: 两个设备分别作为发起方和接收方
2. **声波交换**: 
   - 发起方创建offer并通过声波发送
   - 接收方收到offer后创建answer并通过声波回传
   - 双方通过声波交换ICE候选信息
3. **连接建立**: WebRTC连接建立后，可以通过数据通道进行通信

## 注意事项

1. 设备需要麦克风和扬声器支持
2. 设备需要在相对较近的距离内（声波传输距离有限）
3. 环境噪音可能影响声波通信质量
4. 仅适用于局域网环境
5. 声波传输需要一定时间，请耐心等待连接建立

## API参考

### WaveRTC类

#### 构造函数
```javascript
new WaveRTC(options)
```

#### 方法

- `init(isInitiator)`: 初始化连接
- `sendMessage(message)`: 发送消息
- `close()`: 关闭连接
- `connected()`: 检查连接状态

#### 事件

- `connected`: 连接建立成功
- `disconnected`: 连接断开
- `datachannel-open`: 数据通道打开
- `data`: 接收到数据
- `error`: 发生错误
- `closed`: 连接完全关闭

## 许可证

MIT