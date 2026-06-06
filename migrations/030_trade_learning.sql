-- Trade learning capture (v0.28.1)
-- Stores AI-generated learning notes captured when a paper trade closes or expires.
-- learning_json: JSON blob matching TradeLearning interface (strategyWorked, entryFit, keyLesson, suggestedTweak).
ALTER TABLE paper_trades ADD COLUMN learning_json TEXT;
