fn addition(a: i32, b: i32) -> i32 {
    a + b
}

fn multiplication(a: i32, b: i32) -> i32 {
    a * b
}

fn main() {
    let result = addition(5, 3);
    println!("The sum of 5 and 3 is {}", result);
    let result = multiplication(4, 6);
    println!("The product of 4 and 6 is {}", result);
}

}

// This code defines a function `addition` that takes two integers as input and returns their sum. The `main` function demonstrates how to call the `addition` function with specific values and prints the result.
// 
// In this example, we define a function called `addition` that takes two integers as parameters and returns their sum. We then create an instance of the `addition` function by passing in the arguments 5 and 3, and store the result in the variable `result`.
// Finally, we print the value of `result`, which is the sum of 5 and 3.

