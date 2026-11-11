class Calculator:
    def add(self, left: int, right: int) -> int:
        # Deliberate exercise defect: subtraction should be addition.
        return left - right

if __name__ == "__main__":
    print(Calculator().add(2, 3))
