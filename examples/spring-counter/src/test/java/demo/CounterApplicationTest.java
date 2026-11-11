package demo;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class CounterApplicationTest {
    @Test void endpointLogic() { assertEquals(5, CounterApplication.calculate()); }
}
