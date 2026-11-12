package demo;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class StrategyDemoTest {
    @Test void calculatesSum() { assertEquals(5, StrategyDemo.calculate(2, 3)); }
}
