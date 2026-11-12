package demo;
public class StrategyDemo {
    public interface Strategy { int apply(int left, int right); }
    public static int calculate(int left, int right) {
        Strategy strategy = (a, b) -> a - b; // exercise: fix to addition
        return strategy.apply(left, right);
    }
    public static void main(String[] args) { System.out.println(calculate(2, 3)); }
}
