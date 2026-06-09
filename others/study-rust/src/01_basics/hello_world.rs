// Rust 学习案例 1: Hello World
// 这是 Rust 的第一个程序

fn main() {
    // 使用 println! 宏打印字符串
    println!("Hello, World!");
    
    // 打印多个值
    println!("Hello, {}!", "Rust");
    
    // 使用命名参数
    println!(
        "{name} 今年 {age} 岁",
        name = "张三",
        age = 25
    );
    
    // 格式化输出
    println!("二进制: {:b}", 10);  // 二进制
    println!("八进制: {:o}", 10);  // 八进制
    println!("十六进制: {:x}", 10); // 十六进制
}