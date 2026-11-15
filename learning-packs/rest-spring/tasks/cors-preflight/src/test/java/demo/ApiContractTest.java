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
    @Test void realCorsPreflightOverHttp() throws Exception {
        var preflight = request("OPTIONS","/items/1",null,"Origin","https://student.example","Access-Control-Request-Method","GET","Access-Control-Request-Headers","content-type");
        assertEquals(200,preflight.statusCode());
        assertEquals("https://student.example",preflight.headers().firstValue("Access-Control-Allow-Origin").orElse(""),"Only the declared origin may be allowed");
        assertTrue(Arrays.asList(preflight.headers().firstValue("Access-Control-Allow-Methods").orElse("").split(",\\s*")).contains("GET"));
        assertTrue(preflight.headers().firstValue("Access-Control-Allow-Headers").orElse("").toLowerCase(Locale.ROOT).contains("content-type"));
        var get = request("GET","/items/1",null,"Origin","https://student.example");assertEquals(200,get.statusCode());
        assertEquals("https://student.example",get.headers().firstValue("Access-Control-Allow-Origin").orElse(""));
        assertEquals("{\"id\":1,\"name\":\"notes\"}",get.body());
        for (var denied : List.of(request("OPTIONS","/items/1",null,"Origin","https://evil.example","Access-Control-Request-Method","GET"),request("OPTIONS","/items/1",null,"Origin","https://student.example","Access-Control-Request-Method","POST"),request("GET","/items/1",null,"Origin","https://evil.example"))) {
            assertEquals(403,denied.statusCode());assertTrue(denied.headers().firstValue("Access-Control-Allow-Origin").isEmpty());
        }
        assertEquals(200,request("GET","/items/1",null).statusCode());
    }
}
