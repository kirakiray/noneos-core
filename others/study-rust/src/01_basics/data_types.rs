// Rust 学习案例 3: 数据类型

fn main() {
    // 标量类型
    
    // 整数类型
    let a: i32 = -5;          // 有符号 32 位整数
    let b: u32 = 10;          // 无符号 32 位整数
    let c: i64 = 100;         // 有符号 64 位整数
    println!("整数: {}, {}, {}", a, b, c);
    
    // 浮点类型
    let x = 2.0;              // f64（默认）
    let y: f32 = 3.0;         // f32
    println!("浮点数: {}, {}", x, y);
    
    // 布尔类型
    let t = true;
    let f: bool = false;
    println!("布尔值: {}, {}", t, f);
    
    // 字符类型
    let z = 'ℤ';
    let heart_eyed_cat = '😻';
    println!("字符: {}, {}", z, heart_eyed_cat);
    
    // 复合类型
    
    // 元组
    let tup: (i32, f64, u8) = (500, 6.4, 1);
    let (x, y, z) = tup;
    println!("元组解构: {}, {}, {}", x, y, z);
    println!("元组索引: {}", tup.0);
    
    // 数组
    let arr = [1, 2, 3, 4, 5];
    println!("数组: {:?}", arr);
    
    // 类型推断
    let guess = "42".parse::<i32>().expect("不是数字！");
    println!("解析的数字: {}", guess);
}