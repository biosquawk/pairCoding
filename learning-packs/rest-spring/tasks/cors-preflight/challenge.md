# Skonfiguruj CORS dla jednego origin

Zezwól https://student.example na GET /items/1. Realne OPTIONS preflight ma dać 200, Access-Control-Allow-Origin równy temu origin i GET w Access-Control-Allow-Methods, dopuszczając Content-Type. Rzeczywisty GET z tego origin daje 200/JSON i ten sam allow-origin. Obcy origin i preflight POST są odrzucane 403 bez allow-origin. GET bez Origin nadal działa. To kontrakt przeglądarki, nie mechanizm uwierzytelnienia. Starter otwiera endpoint dla dowolnej witryny.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: browser-collections. Autorskie opracowanie PairCoach, nie książka użytkownika.
