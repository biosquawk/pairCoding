package demo;

public final class Puzzler {
    // Zachowaj demonstrator: badamy semantykę tego wyrażenia.
    public static String observed() {
        return String.valueOf(12345 + 5432l);
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
