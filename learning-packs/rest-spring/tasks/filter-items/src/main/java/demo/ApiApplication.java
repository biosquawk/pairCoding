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
    record Item(long id, String name) {}
    private final List<Item> items = List.of(new Item(1,"notes"),new Item(2,"tasks"));
    @GetMapping("/items")
    public List<Item> list(@RequestParam(value="q",defaultValue="") String q) {
        return items;
    }
}
