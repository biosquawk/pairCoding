package demo;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import org.junit.jupiter.api.*;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import static org.junit.jupiter.api.Assertions.*;
class ApiContractTest {
    ConfigurableApplicationContext app;
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    String base;
    @BeforeEach void start() {
        app = new SpringApplication(ApiApplication.class).run("--server.port=0", "--spring.main.banner-mode=off");
        base = "http://127.0.0.1:" + app.getEnvironment().getProperty("local.server.port");
    }
    @AfterEach void stop() { if (app != null) app.close(); }
    HttpRequest build(String method, String route, String body, String... headers) {
        var b = HttpRequest.newBuilder(URI.create(base + route)).timeout(Duration.ofSeconds(10)).header("Content-Type","application/json");
        for (int i=0; i<headers.length; i+=2) b.header(headers[i],headers[i+1]);
        return b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build();
    }
    HttpResponse<String> request(String method, String route, String body, String... headers) throws Exception {
        return client.send(build(method,route,body,headers), HttpResponse.BodyHandlers.ofString());
    }
    @Test void paginationOverHttp() throws Exception {
        String first = "[{\"id\":1,\"name\":\"notes\"},{\"id\":2,\"name\":\"tasks\"}]";
        assertEquals(first,request("GET","/items",null).body());
        assertEquals(first,request("GET","/items?page=0&size=2",null).body());
        assertEquals("[{\"id\":3,\"name\":\"book\"},{\"id\":4,\"name\":\"pen\"}]",request("GET","/items?page=1&size=2",null).body(),"Offset must be page*size, without overlap");
        assertEquals("[{\"id\":5,\"name\":\"map\"}]",request("GET","/items?page=2&size=2",null).body());
        assertEquals("[{\"id\":2,\"name\":\"tasks\"}]",request("GET","/items?page=1&size=1",null).body());
        for (String route : List.of("/items?page=10&size=2","/items?page=2147483647&size=3")) { var r = request("GET",route,null);assertEquals(200,r.statusCode());assertEquals("[]",r.body()); }
        for (String route : List.of("/items?page=-1","/items?size=0","/items?size=4","/items?page=no","/items?size=1.5")) assertEquals(400,request("GET",route,null).statusCode());
        assertEquals(first,request("GET","/items",null).body());
    }
}
