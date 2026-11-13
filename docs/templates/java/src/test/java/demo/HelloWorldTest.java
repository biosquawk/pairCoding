package demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HelloWorldTest {
    @Test void positive() { assertEquals(5, HelloWorld.sum(2, 3)); }
    @Test void negative() { assertEquals(3, HelloWorld.sum(-2, 5)); }
    @Test void zero() { assertEquals(0, HelloWorld.sum(0, 0)); }
}
