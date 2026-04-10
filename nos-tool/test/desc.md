现在我有个测试用组件 nos-tool/test/ok-test.mjs ，它的使用案例在 nos-tool/test/demo/test-examples.html 和 nos-tool/test/demo/test-parallel.html ；

帮我开发一个集合行的测试组件 nos-tool/test/ok-group-test.mjs ，要联动 ok-test 组件 ，使用方法如 nos-tool/test/demo/all.html ，功能为：

- 获取对应include标签的资源地址
- iframe 运行对应的html文件
- iframe里的ok-test 组件在加载完成后，给100毫秒延迟，然后得到总共要测试的个数，通过 postMessage 返回给 ok-group-test 组件
- ok-group-test 组件收到这个消息后，显示个数
- iframe里的ok-test 组件在测试完成后，通过 postMessage 返回测试结果和信息到 ok-group-test 组件，无论是成功数据还是失败数据都要告知给 ok-group-test 组件
- 如果某个iframe测试失败，则显示错误个数和错误结果
- 如果某个iframe测试成功，则显示成功个数和成功结果
- ok-group-test 显示总个数，和成功个数，错误个数
- ok-group-test 组件的样式参考 ok-test 组件的样式