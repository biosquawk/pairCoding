package demo;

public final class Puzzler {
    // Zachowaj demonstrator: badamy semantykę tego wyrażenia.
    public static String observed() {
        return Long.toHexString(0x100000000L + 0xcafebabe);
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
