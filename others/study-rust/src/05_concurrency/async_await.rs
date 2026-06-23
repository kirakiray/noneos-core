// Rust 学习案例 15: 异步编程（Async/Await）
// 使用 tokio 运行时进行异步编程

use std::time::Duration;
use tokio::time::sleep;

#[tokio::main]
async fn main() {
    println!("=== 异步函数 ===");
    
    // 调用异步函数
    let result = say_hello_async().await;
    println!("{}", result);

    // 并发执行多个异步任务
    println!("\n=== 并发执行 ===");
    let future1 = async_task("任务1", 2);
    let future2 = async_task("任务2", 1);
    
    // 使用 tokio::join! 并发执行
    let (result1, result2) = tokio::join!(future1, future2);
    println!("结果: {}, {}", result1, result2);

    // 异步错误处理
    println!("\n=== 异步错误处理 ===");
    match async_may_fail().await {
        Ok(value) => println!("成功: {}", value),
        Err(e) => println!("错误: {}", e),
    }

    // 使用 tokio::select!
    println!("\n=== tokio::select! ===");
    let result = tokio::select! {
        res1 = async_task("选择1", 1) => res1,
        res2 = async_task("选择2", 2) => res2,
    };
    println!("选择结果: {}", result);

    // 异步流
    println!("\n=== 异步流 ===");
    use tokio_stream::StreamExt;
    
    let mut stream = tokio_stream::iter(1..=5);
    while let Some(value) = stream.next().await {
        println!("流值: {}", value);
    }

    // 异步通道
    println!("\n=== 异步通道 ===");
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);

    tokio::spawn(async move {
        for i in 0..5 {
            tx.send(format!("消息 {}", i)).await.unwrap();
            sleep(Duration::from_millis(100)).await;
        }
    });

    while let Some(msg) = rx.recv().await {
        println!("收到: {}", msg);
    }

    // 异步锁
    println!("\n=== 异步锁 ===");
    let data = Arc::new(tokio::sync::Mutex::new(0));
    let mut handles = vec![];

    for i in 0..5 {
        let data = Arc::clone(&data);
        let handle = tokio::spawn(async move {
            let mut lock = data.lock().await;
            *lock += i;
            println!("线程 {} 增加计数", i);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    println!("最终计数: {}", *data.lock().await);
}

// 异步函数
async fn say_hello_async() -> String {
    sleep(Duration::from_millis(500)).await;
    String::from("异步你好！")
}

// 带参数的异步函数
async fn async_task(name: &str, seconds: u64) -> String {
    sleep(Duration::from_secs(seconds)).await;
    format!("{} 完成", name)
}

// 可能失败的异步函数
async fn async_may_fail() -> Result<String, String> {
    sleep(Duration::from_millis(100)).await;
    Ok(String::from("异步操作成功"))
}

// 异步迭代器示例
async fn async_iterator_example() {
    use tokio_stream::StreamExt;
    
    let stream = tokio_stream::iter(vec![1, 2, 3, 4, 5]);
    
    tokio::pin!(stream);
    
    while let Some(value) = stream.next().await {
        println!("值: {}", value);
    }
}

// 异步文件操作示例（需要启用 tokio 的 fs feature）
// async fn async_file_example() -> std::io::Result<()> {
//     use tokio::fs::File;
//     use tokio::io::AsyncReadExt;
//     
//     let mut file = File::open("hello.txt").await?;
//     let mut contents = String::new();
//     file.read_to_string(&mut contents).await?;
//     println!("文件内容: {}", contents);
//     Ok(())
// }

// 异步网络操作示例（需要启用 tokio 的 net feature）
// async fn async_network_example() -> std::io::Result<()> {
//     use tokio::net::TcpListener;
//     
//     let listener = TcpListener::bind("localhost:8080").await?;
//     
//     loop {
//         let (socket, _) = listener.accept().await?;
//         
//         tokio::spawn(async move {
//             // 处理连接
//         });
//     }
// }