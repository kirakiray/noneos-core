// Rust 学习案例 2: 变量和可变性

fn main() {
    // 不可变变量（默认）
    let x = 5;
    println!("x 的值是: {}", x);
    // x = 6; // 错误！不能对不可变变量重新赋值
    
    // 可变变量
    let mut y = 5;
    println!("y 的初始值: {}", y);
    y = 6;
    println!("y 的新值: {}", y);
    
    // 变量遮蔽（shadowing）
    let z = 5;
    let z = z + 1; // 遮蔽之前的 z
    let z = z * 2; // 再次遮蔽
    println!("z 的值是: {}", z);
    
    // 常量（必须注明类型，且不能用函数返回值赋值）
    const MAX_POINTS: u32 = 100_000;
    println!("最大分数: {}", MAX_POINTS);
    
    // 元组解构
    let tuple = (1, 2.5, "hello");
    let (a, b, c) = tuple;
    println!("元组: {}, {}, {}", a, b, c);
    
    // 数组
    let arr = [1, 2, 3, 4, 5];
    println!("数组第一个元素: {}", arr[0]);
}