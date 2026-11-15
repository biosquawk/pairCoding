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
    @CrossOrigin(origins="*", methods=RequestMethod.GET)
    @GetMapping("/items/1")
    public Item get() { return new Item(1,"notes"); }
}
