// Rust 学习案例 13: 自定义错误类型

use std::fmt;
use std::error::Error;
use std::num::ParseIntError;

// 自定义错误类型
#[derive(Debug)]
enum MyError {
    IoError(std::io::Error),
    ParseError(ParseIntError),
    CustomError(String),
}

// 实现 Display trait
impl fmt::Display for MyError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            MyError::IoError(e) => write!(f, "IO 错误: {}", e),
            MyError::ParseError(e) => write!(f, "解析错误: {}", e),
            MyError::CustomError(msg) => write!(f, "自定义错误: {}", msg),
        }
    }
}

// 实现 Error trait
impl Error for MyError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            MyError::IoError(e) => Some(e),
            MyError::ParseError(e) => Some(e),
            MyError::CustomError(_) => None,
        }
    }
}

// 从 std::io::Error 转换
impl From<std::io::Error> for MyError {
    fn from(error: std::io::Error) -> Self {
        MyError::IoError(error)
    }
}

// 从 ParseIntError 转换
impl From<ParseIntError> for MyError {
    fn from(error: ParseIntError) -> Self {
        MyError::ParseError(error)
    }
}

// 使用自定义错误的函数
fn parse_and_divide(a: &str, b: &str) -> Result<f64, MyError> {
    let a: i32 = a.parse()?;  // 自动转换为 MyError
    let b: i32 = b.parse()?;
    
    if b == 0 {
        return Err(MyError::CustomError("除数不能为零".to_string()));
    }
    
    Ok(a as f64 / b as f64)
}

// 使用 thiserror 库的简化版本（需要添加依赖）
// use thiserror::Error;
// 
// #[derive(Error, Debug)]
// enum MyErrorWithThiserror {
//     #[error("IO 错误: {0}")]
//     IoError(#[from] std::io::Error),
//     
//     #[error("解析错误: {0}")]
//     ParseError(#[from] ParseIntError),
//     
//     #[error("自定义错误: {0}")]
//     CustomError(String),
// }

fn main() {
    // 测试自定义错误
    match parse_and_divide("10", "2") {
        Ok(result) => println!("结果: {}", result),
        Err(e) => eprintln!("错误: {}", e),
    }

    match parse_and_divide("10", "0") {
        Ok(result) => println!("结果: {}", result),
        Err(e) => eprintln!("错误: {}", e),
    }

    match parse_and_divide("abc", "2") {
        Ok(result) => println!("结果: {}", result),
        Err(e) => eprintln!("错误: {}", e),
    }

    // 使用 ? 运算符传播错误
    fn example() -> Result<(), MyError> {
        let result = parse_and_divide("10", "2")?;
        println!("计算结果: {}", result);
        Ok(())
    }

    // 运行示例
    if let Err(e) = example() {
        eprintln!("示例出错: {}", e);
    }

    // 链式错误处理
    fn chain_example() -> Result<String, MyError> {
        let a = "10".parse::<i32>()?;
        let b = "2".parse::<i32>()?;
        let result = a + b;
        Ok(format!("结果是: {}", result))
    }

    match chain_example() {
        Ok(msg) => println!("{}", msg),
        Err(e) => eprintln!("链式操作出错: {}", e),
    }

    // 错误上下文
    fn with_context() -> Result<i32, MyError> {
        "not a number"
            .parse::<i32>()
            .map_err(|e| MyError::CustomError(format!("解析失败: {}", e)))?;
        Ok(0)
    }

    match with_context() {
        Ok(n) => println!("数字: {}", n),
        Err(e) => eprintln!("上下文错误: {}", e),
    }
}