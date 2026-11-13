package demo;

public final class Puzzler {
    public static String declarations() { return "Object x = \"a\"; String i = \"b\";"; }
    public static String simplePrediction() { return "TODO"; }
    public static String compoundPrediction() { return "TODO"; }
    public static void main(String[] args) {
        System.out.println(declarations());
        System.out.println("x = x + i: " + simplePrediction());
        System.out.println("x += i: " + compoundPrediction());
    }
}
