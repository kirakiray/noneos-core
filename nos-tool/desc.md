我在 nos-tool/ai/pages/key-manager.html 添加了key到本地；请在 nos/ai/chat.js 中添加默认函数，它的要求是：
* 直接暴露一个chat函数，允许用于聊天用的函数；
* 这个chat支持数据流模式聊天；数据流对话通过options上的callback函数进行回调；这个callback要带上当前对话的provider者；
* 这个chat函数使用我存到本地的key和对应选择的provider进行聊天；
* 这个chat可以传入provider，就使用对应key的本地provider进行聊天；
* chat如果传入provider，如果超出并发数，则报错说超出并发数；
* chat如果没有传入provider，则随机使用本地保存的key和provider进行聊天；
* 每个key都有并发数，chat如果没有传入provider，则不能选择已经达到并发数的key，选择未达到最大并发数的key；
* 报错都要告知当前对话失败的provider，失败原因；不要直接暴露完全的key，只暴露key的前12位；
