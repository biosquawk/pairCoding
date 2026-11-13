package demo;

public final class Puzzler {
    // Zachowaj demonstrator: badamy semantykę tego wyrażenia.
    public static String observed() {
        long microseconds = 24 * 60 * 60 * 1000 * 1000;
        long milliseconds = 24 * 60 * 60 * 1000;
        return String.valueOf(microseconds / milliseconds);
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
