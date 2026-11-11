package demo;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@SpringBootApplication
@RestController
public class CounterApplication {
    public static int calculate() { return 2 - 3; } // exercise: fix addition
    @GetMapping("/sum") public int sum() { return calculate(); }
    public static void main(String[] args) { SpringApplication.run(CounterApplication.class, args); }
}
