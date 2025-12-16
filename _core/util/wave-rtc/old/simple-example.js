// WaveRTC 简单使用示例
import WaveRTC from './main.js';

// 发起方示例
async function startAsInitiator() {
  const rtc = new WaveRTC();
  
  // 监听连接事件
  rtc.addEventListener('connected', () => {
    console.log('连接已建立!');
    
    // 发送消息
    rtc.sendMessage('你好，接收方!');
  });
  
  // 监听接收消息
  rtc.addEventListener('data', (event) => {
    console.log('收到消息:', event.detail.message);
  });
  
  // 初始化为发起方
  await rtc.init(true);
}

// 接收方示例
async function startAsReceiver() {
  const rtc = new WaveRTC();
  
  // 监听连接事件
  rtc.addEventListener('connected', () => {
    console.log('连接已建立!');
  });
  
  // 监听接收消息
  rtc.addEventListener('data', (event) => {
    console.log('收到消息:', event.detail.message);
    
    // 回复消息
    rtc.sendMessage('你好，发起方!');
  });
  
  // 初始化为接收方
  await rtc.init(false);
}

// 导出函数供外部使用
export { startAsInitiator, startAsReceiver };