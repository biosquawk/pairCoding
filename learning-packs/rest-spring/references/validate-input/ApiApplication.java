package demo;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication
@RestController
public class ApiApplication {
    public static void main(String[] args) { SpringApplication.run(ApiApplication.class, args); }
    record Input(String name, BigDecimal quantity) {}
    record Order(String name, int quantity) {}
    @PostMapping("/orders")
    public ResponseEntity<Order> create(@RequestBody Input input) {
        if (input == null || input.name() == null || input.name().isBlank() || input.quantity() == null || input.quantity().stripTrailingZeros().scale() > 0 || input.quantity().compareTo(BigDecimal.ONE) < 0 || input.quantity().compareTo(BigDecimal.valueOf(100)) > 0) return ResponseEntity.badRequest().build();
        return ResponseEntity.created(java.net.URI.create("/orders/1")).body(new Order(input.name(), input.quantity().intValueExact()));
    }
}
