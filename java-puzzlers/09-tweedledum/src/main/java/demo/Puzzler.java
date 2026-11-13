package demo;

public final class Puzzler {
    // Zwróć kompletny kod dwóch lokalnych deklaracji x oraz i.
    public static String declarations() {
        return "// TODO: deklaracje x oraz i";
    }
    public static void main(String[] args) {
        System.out.println(declarations());
        System.out.println("LEGAL: x += i;");
        System.out.println("ILLEGAL: x = x + i;");
    }
}
