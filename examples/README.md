# Five small training examples — TEST101–107
These are source exercises, NOT LIVE/GUI/toolchain proof. Each intentionally subtracts instead of
adding; Run Tests must fail, edit subtraction to addition, ACK, then Run Tests must pass with fresh
JUnit. Do not change tests to match the defect. Main prints the current result.

|TEST|workspace/profile|Main entry|test selectors|
|---|---|---|---|
|101|javascript-counter/javascript-node|SCRIPT main.js|paths=[counter.test.js]|
|102|typescript-counter/typescript-node|SCRIPT main.ts|paths=[counter.test.ts]|
|103–105|java-pattern/java-maven-11/17/21/27|JAVA_MAIN demo.StrategyDemo|paths=[],names=[demo.StrategyDemoTest]|
|106|spring-counter/java-maven-21/27|SPRING_BOOT port8080 healthPath=/sum|paths=[],names=[demo.CounterApplicationTest]|
|107|python-calculator/python-3.13|SCRIPT calculator.py|paths=[test_calculator.py]|

workingDirectory is `.` for all. Each workspace contains task.v2.json with the two explicit profiles;
this is an input template for the later V2 settings integration, not an automatic migration. No old
settings are overwritten. Java defaults release11; **human** changes pom release to17/21/27 before
selecting the matching profile. Spring defaults21; human changes both java.version and release to27.
No adapter rewrite/downgrade or hidden compiler flag. A mismatch must fail.

For TS temporarily return a string from add to require a real compiler failure before fixing its type.
For Java/Python completion, invoke on an instance, rename add/calculate and observe new members;
introduce then fix a type/reference error. These GUI/LSP steps and AI/Veto are NOT_RUN in wave1.
For Spring after logic tests pass, Run Main, await actual HTTP /sum through executor loopback mapping,
then Stop and require confirmed container exit + unavailable HTTP; HTTP ready is not Run success.

Production images are **not prepared** by this delivery. Follow ../runtimes/README.md.
Python needs a reviewed hash-locked requirements.txt (pytest + transitives); the placeholder intentionally
cannot yield a ready cache. Source versions in Maven POMs are requested pins, not verified downloaded
artifact identities. Offline prepare, all four JDKs, Spring21/27, and full TEST101–107 remain NOT_RUN.
