package demo;

public final class Puzzler {
    // Zachowaj demonstrator: badamy semantykę tego wyrażenia.
    public static String observed() {
        char letter = 'X';
        int number = 0;
        return String.valueOf(true ? letter : 0) + String.valueOf(false ? number : letter);
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
