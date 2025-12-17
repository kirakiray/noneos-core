import { GgwaveReceiver } from "../../../libs/ggwave/main.js";
import { send } from "../../../libs/ggwave/main.js";
import { compressText, uncompressText } from "../../../libs/ggwave/compress.js";

/**
 * 基于声波通信的WebRTC连接交换库
 * 用于在局域网内通过声波交换WebRTC连接信息
 */
class WaveRTC extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = {
      // STUN服务器配置
      iceServers: [], // 局域网内，不需要ice
      // ggwave配置
      ggwave: options.ggwave || {},
    };

    this.peerConnection = null;
    this.dataChannel = null;
    this.receiver = null;
    this.isInitiator = false;
    this.isConnected = false;
  }

  /**
   * 初始化WebRTC连接
   * @param {boolean} isInitiator - 是否为发起方
   * @returns {Promise<void>}
   */
  async init(isInitiator = false) {
    this.isInitiator = isInitiator;

    // 创建RTCPeerConnection
    this.peerConnection = new RTCPeerConnection({
      iceServers: this.options.iceServers,
    });

    // 监听连接状态变化
    this.peerConnection.onconnectionstatechange = () => {
      console.log("Connection state:", this.peerConnection.connectionState);
      if (this.peerConnection.connectionState === "connected") {
        this.isConnected = true;
        this.dispatchEvent(new CustomEvent("connected"));
      } else if (this.peerConnection.connectionState === "failed") {
        this.dispatchEvent(
          new CustomEvent("error", {
            detail: { message: "Connection failed" },
          })
        );
      }
    };

    // 监听ICE候选
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        // 通过声波发送ICE候选
        this.sendViaSound({ type: "ice-candidate", data: event.candidate });
      }
    };

    if (isInitiator) {
      // 发起方创建数据通道
      this.dataChannel = this.peerConnection.createDataChannel("wave-rtc-data");
      this.setupDataChannelEvents();

      // 创建offer
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // 通过声波发送offer
      await this.sendViaSound({ type: "offer", data: offer });
    } else {
      // 接收方监听数据通道
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannelEvents();
      };
    }

    // 启动声波接收器
    await this.startSoundReceiver();
  }

  /**
   * 设置数据通道事件监听
   */
  setupDataChannelEvents() {
    this.dataChannel.onopen = () => {
      console.log("Data channel opened");
      this.dispatchEvent(new CustomEvent("datachannel-open"));
    };

    this.dataChannel.onmessage = (event) => {
      console.log("Received message:", event.data);
      this.dispatchEvent(
        new CustomEvent("data", {
          detail: { message: event.data },
        })
      );
    };

    this.dataChannel.onclose = () => {
      console.log("Data channel closed");
      this.isConnected = false;
      this.dispatchEvent(new CustomEvent("disconnected"));
    };

    this.dataChannel.onerror = (error) => {
      console.error("Data channel error:", error);
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: { message: "Data channel error", error },
        })
      );
    };
  }

  /**
   * 启动声波接收器
   */
  async startSoundReceiver() {
    this.receiver = new GgwaveReceiver();

    // 监听接收到的消息
    this.receiver.addEventListener("ggwave-message", async (event) => {
      try {
        const { message } = event.detail;
        console.log("Received via sound:", message);

        const data = JSON.parse(message);
        await this.handleReceivedData(data);
      } catch (error) {
        console.error("Error parsing received message:", error);
      }
    });

    await this.receiver.start();
  }

  /**
   * 处理通过声波接收到的数据
   * @param {Object} data - 接收到的数据
   */
  async handleReceivedData(data) {
    switch (data.type) {
      case "offer":
        debugger;
        await this.handleOffer(data.data);
        break;
      case "answer":
        debugger;
        await this.handleAnswer(data.data);
        break;
      case "ice-candidate":
        debugger;
        await this.handleIceCandidate(data.data);
        break;
      default:
        console.warn("Unknown message type:", data.type);
    }
  }

  /**
   * 处理接收到的offer
   * @param {Object} offer - RTC会话描述
   */
  async handleOffer(offer) {
    if (!this.isInitiator) {
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(offer)
      );
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      // 通过声波发送answer
      await this.sendViaSound({ type: "answer", data: answer });
    }
  }

  /**
   * 处理接收到的answer
   * @param {Object} answer - RTC会话描述
   */
  async handleAnswer(answer) {
    if (this.isInitiator) {
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(answer)
      );
    }
  }

  /**
   * 处理接收到的ICE候选
   * @param {Object} candidate - ICE候选
   */
  async handleIceCandidate(candidate) {
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  }

  /**
   * 通过声波发送数据
   * @param {Object} data - 要发送的数据
   */
  async sendViaSound(data) {
    try {
      const message = JSON.stringify(data);

      // 压缩消息
      const compressedMessage = await compressText(message);

      console.log("message: ", message);
      await send(message, this.options.ggwave.volume || 1.0);
    } catch (error) {
      console.error("Error sending via sound:", error);
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: { message: "Failed to send via sound", error },
        })
      );
    }
  }

  /**
   * 通过数据通道发送消息
   * @param {string} message - 要发送的消息
   */
  sendMessage(message) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(message);
    } else {
      console.warn("Data channel is not open");
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: { message: "Data channel is not open" },
        })
      );
    }
  }

  /**
   * 关闭连接
   */
  async close() {
    this.isConnected = false;

    if (this.dataChannel) {
      this.dataChannel.close();
    }

    if (this.peerConnection) {
      this.peerConnection.close();
    }

    if (this.receiver) {
      await this.receiver.stop();
    }

    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * 检查是否已连接
   * @returns {boolean}
   */
  connected() {
    return this.isConnected;
  }
}

export default WaveRTC;
