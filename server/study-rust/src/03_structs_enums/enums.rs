// Rust 学习案例 10: 枚举（Enums）

// 定义枚举
enum IpAddr {
    V4(u8, u8, u8, u8),
    V6(String),
}

// 带方法的枚举
impl IpAddr {
    fn show(&self) {
        match self {
            IpAddr::V4(a, b, c, d) => {
                println!("IPv4: {}.{}.{}.{}", a, b, c, d);
            }
            IpAddr::V6(addr) => {
                println!("IPv6: {}", addr);
            }
        }
    }
}

// Option 枚举（Rust 标准库）
// enum Option<T> {
//     Some(T),
//     None,
// }

// Result 枚举（Rust 标准库）
// enum Result<T, E> {
//     Ok(T),
//     Err(E),
// }

// 自定义枚举
enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
    ChangeColor(i32, i32, i32),
}

impl Message {
    fn call(&self) {
        match self {
            Message::Quit => println!("退出"),
            Message::Move { x, y } => println!("移动到 ({}, {})", x, y),
            Message::Write(text) => println!("文本: {}", text),
            Message::ChangeColor(r, g, b) => println!("改变颜色: RGB({}, {}, {})", r, g, b),
        }
    }
}

fn main() {
    // 创建枚举值
    let home = IpAddr::V4(127, 0, 0, 1);
    let loopback = IpAddr::V6(String::from("::1"));

    home.show();
    loopback.show();

    // Option 枚举
    let some_number = Some(5);
    let some_string = Some("一个字符串");
    let absent_number: Option<i32> = None;

    println!("some_number: {:?}", some_number);
    println!("some_string: {:?}", some_string);
    println!("absent_number: {:?}", absent_number);

    // 使用 Option
    let x: i32 = 5;
    let y: Option<i32> = Some(5);

    match y {
        Some(i) => println!("x + y = {}", x + i),
        None => println!("y 是 None"),
    }

    // if let 简化
    if let Some(i) = y {
        println!("x + y = {}", x + i);
    }

    // Message 枚举
    let m1 = Message::Quit;
    let m2 = Message::Move { x: 10, y: 20 };
    let m3 = Message::Write(String::from("你好"));
    let m4 = Message::ChangeColor(255, 0, 0);

    m1.call();
    m2.call();
    m3.call();
    m4.call();

    // Result 枚举
    let success: Result<i32, &str> = Ok(42);
    let failure: Result<i32, &str> = Err("出错了");

    match success {
        Ok(value) => println!("成功: {}", value),
        Err(e) => println!("错误: {}", e),
    }

    // unwrap 和 expect
    let value = success.unwrap();
    println!("值: {}", value);

    // let value = failure.unwrap();  // 会 panic!
    
    // 更安全的方式
    let value = failure.unwrap_or(0);
    println!("值或默认值: {}", value);
}