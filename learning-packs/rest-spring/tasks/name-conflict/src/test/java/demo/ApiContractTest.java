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
    @Test void domainConflictOverHttp() throws Exception {
        var ok = request("PUT","/items/1/name","{\"name\":\"alpha\"}");assertEquals(200,ok.statusCode());
        assertEquals("{\"id\":1,\"name\":\"alpha\"}",ok.body());
        var conflict = request("PUT","/items/1/name","{\"name\":\"tasks\"}");assertEquals(409,conflict.statusCode(),"Duplicate name is a conflict");
        assertTrue(conflict.headers().firstValue("Content-Type").orElse("").contains("application/json"));
        assertEquals("{\"code\":\"DUPLICATE_NAME\"}",conflict.body());
        assertEquals(ok.body(),request("GET","/items/1",null).body(),"Rejected conflict must not mutate state");
        for (String body : List.of("{}","null","{\"name\":\" \"}")) {
            var bad = request("PUT","/items/1/name",body);assertEquals(400,bad.statusCode());
            assertEquals(ok.body(),request("GET","/items/1",null).body());
        }
        assertEquals(200,request("PUT","/items/1/name","{\"name\":\"beta\"}").statusCode());
        assertEquals("{\"id\":1,\"name\":\"beta\"}",request("GET","/items/1",null).body());
    }
}
