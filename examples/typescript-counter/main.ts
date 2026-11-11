// Deliberate logic defect. To exercise tsc first, temporarily return "wrong" instead.
export function add(a: number, b: number): number { return a - b; }
console.log('add(2, 3) =', add(2, 3));
