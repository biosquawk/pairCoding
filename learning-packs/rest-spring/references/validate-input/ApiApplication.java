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
    record Input(String name, Integer quantity) {}
    @PostMapping("/orders")
    public ResponseEntity<Input> create(@RequestBody Input input) {
        if (input == null || input.name() == null || input.name().isBlank() || input.quantity() == null || input.quantity() < 1 || input.quantity() > 100) return ResponseEntity.badRequest().build();
        return ResponseEntity.created(java.net.URI.create("/orders/1")).body(input);
    }
}
