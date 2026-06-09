// Rust 学习案例 4: 函数

fn main() {
    // 调用函数
    say_hello();
    
    // 带参数的函数
    print_labeled_measurement(5, 'h');
    
    // 有返回值的函数
    let x = five();
    println!("five() 返回: {}", x);
    
    let sum = add(5, 3);
    println!("5 + 3 = {}", sum);
    
    // 表达式作为返回值
    let y = {
        let x = 3;
        x + 1  // 注意：没有分号，这是一个表达式
    };
    println!("y 的值: {}", y);
    
    // 函数作为参数
    let result = apply_operation(5, double);
    println!("5 * 2 = {}", result);
}

// 无返回值的函数
fn say_hello() {
    println!("Hello!");
}

// 带参数的函数
fn print_labeled_measurement(value: i32, unit_label: char) {
    println!("测量值: {}{}", value, unit_label);
}

// 返回值
fn five() -> i32 {
    5
}

// 带参数和返回值
fn add(a: i32, b: i32) -> i32 {
    a + b
}

// 函数作为参数
fn apply_operation(x: i32, f: fn(i32) -> i32) -> i32 {
    f(x)
}

fn double(x: i32) -> i32 {
    x * 2
}