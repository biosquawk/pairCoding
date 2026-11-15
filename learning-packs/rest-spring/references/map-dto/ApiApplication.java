package demo;
import java.util.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication
@RestController
public class ApiApplication {
    public static void main(String[] args) { SpringApplication.run(ApiApplication.class, args); }
    record Input(String firstName, String lastName) {}
    record Greeting(String displayName) {}
    @PostMapping("/greetings")
    public ResponseEntity<Greeting> greet(@RequestBody Input input) {
        if (input == null || input.firstName() == null || input.firstName().isBlank() || input.lastName() == null || input.lastName().isBlank()) return ResponseEntity.badRequest().build();
        return ResponseEntity.ok(new Greeting(input.firstName() + " " + input.lastName()));
    }
}
