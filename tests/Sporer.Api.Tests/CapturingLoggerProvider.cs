using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Sporer.Api.Tests;

/// <summary>One thing that was logged: its level, the category it was logged under, the message as written, and the exception, if any.</summary>
internal sealed record LogEntry(LogLevel Level, string Category, string Message, Exception? Exception);

/// <summary>
/// Keeps everything the app logs, at every level, for a test to look at: add it to the host (<c>ConfigureLogging</c>, or as an
/// <see cref="ILoggerProvider"/> service) and filter <see cref="Entries"/> by level, category or text in the assertion.
/// </summary>
internal sealed class CapturingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<LogEntry> _entries = new();

    /// <summary>Everything logged so far, in order.</summary>
    public IReadOnlyCollection<LogEntry> Entries => _entries;

    public ILogger CreateLogger(string categoryName) => new CapturingLogger(categoryName, _entries);

    public void Dispose()
    {
    }

    private sealed class CapturingLogger(string category, ConcurrentQueue<LogEntry> entries) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
            => entries.Enqueue(new LogEntry(logLevel, category, formatter(state, exception), exception));
    }
}
