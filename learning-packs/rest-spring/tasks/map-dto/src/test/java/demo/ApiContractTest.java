package demo;
import java.net.URI;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;
import java.net.http.*;
import java.util.*;
import java.util.concurrent.*;
import java.time.Duration;
import org.junit.jupiter.api.*;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import static org.junit.jupiter.api.Assertions.*;
class ApiContractTest {
    static final JsonMapper JSON = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    static void assertJsonEquals(String expected, String actual) {
        assertJsonEquals(expected, actual, "JSON response differs");
    }
    static void assertJsonEquals(String expected, String actual, String message) {
        assertEquals(JSON.readTree(expected), JSON.readTree(actual), message);
    }
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
    @Test void dtoMappingOverHttp() throws Exception {
        var ada = request("POST","/greetings","{\"firstName\":\"Ada\",\"lastName\":\"Lovelace\"}");
        assertEquals(200,ada.statusCode());
        assertTrue(ada.headers().firstValue("Content-Type").orElse("").contains("application/json"));
        assertJsonEquals("{\"displayName\":\"Ada Lovelace\"}",ada.body(),"Response DTO must map firstName then lastName");
        assertJsonEquals("{\"displayName\":\"Grace Hopper\"}",request("POST","/greetings","{\"firstName\":\"Grace\",\"lastName\":\"Hopper\"}").body());
        for (String body : List.of("{}","{\"firstName\":\"Ada\"}","{\"firstName\":\" \",\"lastName\":\"Lovelace\"}","not-json")) assertEquals(400,request("POST","/greetings",body).statusCode());
    }
}
