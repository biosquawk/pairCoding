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
    private final List<Item> items = List.of(new Item(1,"notes"),new Item(2,"tasks"),new Item(3,"book"),new Item(4,"pen"),new Item(5,"map"));
    @GetMapping("/items")
    public ResponseEntity<List<Item>> list(@RequestParam(value="page",defaultValue="0") int page, @RequestParam(value="size",defaultValue="2") int size) {
        if (page < 0 || size < 1 || size > 3) return ResponseEntity.badRequest().build();
        long offset = (long)page * size;
        if (offset >= items.size()) return ResponseEntity.ok(List.of());
        return ResponseEntity.ok(items.subList((int)offset,(int)Math.min(offset+size,items.size())));
    }
}
