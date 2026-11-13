package demo;

public final class Puzzler {
    // Zachowaj demonstrator: badamy semantykę tego wyrażenia.
    public static String observed() {
        int left = 1984, right = 2001;
        left ^= right ^= left ^= right;
        return "left=" + left + ";right=" + right;
    }

    // Najpierw przewidź wynik bez uruchamiania demonstratora.
    public static String prediction() {
        return "TODO";
    }

    public static void main(String[] args) {
        System.out.println("prediction: " + prediction());
        System.out.println("observed: " + observed());
    }
}
