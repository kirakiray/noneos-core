// Rust 学习案例 14: 并发编程（Concurrency）
// Rust 的并发是"无畏并发"（Fearless Concurrency），编译器会在编译时检查并发错误

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn main() {
    // 创建线程
    println!("=== 创建线程 ===");
    let handle = thread::spawn(|| {
        for i in 1..10 {
            println!("子线程数字: {}", i);
            thread::sleep(Duration::from_millis(1));
        }
    });

    for i in 1..5 {
        println!("主线程数字: {}", i);
        thread::sleep(Duration::from_millis(1));
    }

    handle.join().unwrap();

    // 使用 move 闭包
    println!("\n=== 使用 move 闭包 ===");
    let v = vec![1, 2, 3];
    let handle = thread::spawn(move || {
        println!("向量: {:?}", v);
    });
    handle.join().unwrap();

    // 消息传递（通道）
    println!("\n=== 消息传递 ===");
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let vals = vec![
            String::from("你好"),
            String::from("来自"),
            String::from("子线程"),
        ];

        for val in vals {
            tx.send(val).unwrap();
            thread::sleep(Duration::from_secs(1));
        }
    });

    for received in rx {
        println!("收到: {}", received);
    }

    // 多个生产者
    println!("\n=== 多个生产者 ===");
    let (tx, rx) = mpsc::channel();
    let tx1 = tx.clone();
    
    thread::spawn(move || {
        let vals = vec![
            String::from("线程1: 你好"),
            String::from("线程1: 世界"),
        ];

        for val in vals {
            tx1.send(val).unwrap();
            thread::sleep(Duration::from_millis(100));
        }
    });

    thread::spawn(move || {
        let vals = vec![
            String::from("线程2: 你好"),
            String::from("线程2: 世界"),
        ];

        for val in vals {
            tx.send(val).unwrap();
            thread::sleep(Duration::from_millis(100));
        }
    });

    for received in rx {
        println!("收到: {}", received);
    }

    // 共享状态（Mutex）
    println!("\n=== 共享状态（Mutex）===");
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            let mut num = counter.lock().unwrap();
            *num += 1;
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    println!("最终计数: {}", *counter.lock().unwrap());

    // Send 和 Sync trait
    // Send: 允许在线程间转移所有权
    // Sync: 允许多线程访问
    // 大多数类型自动实现了这些 trait
}