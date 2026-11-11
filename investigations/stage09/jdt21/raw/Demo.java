import java.lang.ScopedValue;
public class Demo {
  static class Helper { public String pairCoachUniqueMethod() { return "żółć 😀"; } }
  ScopedValue<String> scoped = ScopedValue.newInstance();
  void demo() { Helper h = new Helper(); h.pairCoachUniqueMethod();  }
}
