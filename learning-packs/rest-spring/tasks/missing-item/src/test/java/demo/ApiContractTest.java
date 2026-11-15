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
    @Test void missingResourceOverHttp() throws Exception {
        var known = request("GET","/items/1",null);assertEquals(200,known.statusCode());
        assertEquals("{\"id\":1,\"name\":\"notes\"}",known.body());
        for (long id : List.of(2L,99L,-1L)) {
            var r = request("GET","/items/"+id,null);assertEquals(404,r.statusCode(),"Absent resource must be 404, not a successful empty response");
            assertTrue(r.headers().firstValue("Content-Type").orElse("").contains("application/json"));
            assertEquals("{\"code\":\"ITEM_NOT_FOUND\",\"id\":"+id+"}",r.body());
            assertEquals(404,request("GET","/items/"+id,null).statusCode());
        }
        assertEquals(known.body(),request("GET","/items/1",null).body());
    }
}
