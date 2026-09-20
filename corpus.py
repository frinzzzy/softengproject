import pandas as pd
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import make_pipeline

# 1. Load the dataset
df = pd.read_csv("corpus.csv")

# 2. Split data into training and testing sets
X_train, X_test, y_train, y_test = train_test_split(
    df["tale_text"], df["atu_category"], test_size=0.3, random_state=42
)

# 3. Create a Logistic Regression model pipeline
model = make_pipeline(CountVectorizer(), LogisticRegression())

# 4. Train and score the model
model.fit(X_train, y_train)
print(f"Logistic Regression Accuracy: {model.score(X_test, y_test):.2f}")