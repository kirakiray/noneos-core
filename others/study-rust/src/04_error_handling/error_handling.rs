// Rust 学习案例 12: 错误处理
// Rust 将错误分为两类：可恢复错误（Result<T, E>）和不可恢复错误（panic!）

use std::fs::File;
use std::io::{self, Read};

fn main() {
    // panic! - 不可恢复错误
    // panic!("程序崩溃了！");

    // Result<T, E> - 可恢复错误
    let greeting_file_result = File::open("hello.txt");

    let greeting_file = match greeting_file_result {
        Ok(file) => file,
        Err(error) => {
            panic!("打开文件时出错: {:?}", error);
        }
    };

    // 使用 unwrap 和 expect 简化
    // unwrap: 如果 Result 是 Ok，返回值；如果是 Err，调用 panic!
    // let greeting_file = File::open("hello.txt").unwrap();

    // expect: 与 unwrap 类似，但可以自定义错误信息
    // let greeting_file = File::open("hello.txt")
    //     .expect("hello.txt 应该包含在这个项目中");

    // 传播错误
    fn read_username_from_file() -> Result<String, io::Error> {
        let mut username = String::new();
        File::open("username.txt")?.read_to_string(&mut username)?;
        Ok(username)
    }

    // 使用 ? 运算符的简化版本
    fn read_username_from_file_short() -> Result<String, io::Error> {
        let mut username = String::new();
        File::open("username.txt")?.read_to_string(&mut username)?;
        Ok(username)
    }

    // 更简短的版本（使用 std::fs）
    fn read_username_from_file_shorter() -> Result<String, io::Error> {
        std::fs::read_to_string("username.txt")
    }

    // 处理 Result
    match read_username_from_file() {
        Ok(username) => println!("用户名: {}", username),
        Err(e) => println!("读取用户名失败: {}", e),
    }

    // 在 main 函数中使用 Result
    // fn main() -> Result<(), Box<dyn std::error::Error>> {
    //     let greeting_file = File::open("hello.txt")?;
    //     Ok(())
    // }

    // 何时使用 panic! vs Result
    // 示例、原型代码和测试：panic! 更合适
    // 比编译器知道更多信息时：panic! 更合适
    // 其他情况：使用 Result

    // 自定义错误处理
    let result = divide(10.0, 2.0);
    match result {
        Ok(value) => println!("结果: {}", value),
        Err(e) => println!("错误: {}", e),
    }

    let result = divide(10.0, 0.0);
    match result {
        Ok(value) => println!("结果: {}", value),
        Err(e) => println!("错误: {}", e),
    }

    // 使用 unwrap_or 提供默认值
    let value = divide(10.0, 0.0).unwrap_or(0.0);
    println!("默认值: {}", value);

    // 使用 unwrap_or_else 处理错误
    let value = divide(10.0, 0.0).unwrap_or_else(|e| {
        println!("发生错误: {}", e);
        0.0
    });
    println!("处理后的值: {}", value);
}

fn divide(a: f64, b: f64) -> Result<f64, String> {
    if b == 0.0 {
        Err(String::from("除数不能为零"))
    } else {
        Ok(a / b)
    }
}