using DbUp;
using DbUp.Engine.Output;

namespace Sporer.Api.Database;

/// <summary>
/// Applies the embedded SQL scripts in name order, one transaction per script, and records them in
/// the <c>schemaversions</c> journal table. Throws when a script fails, so the application does not start.
/// </summary>
public static class DatabaseMigrator
{
    public static void Migrate(string connectionString, ILogger log)
    {
        var upgrader = DeployChanges.To
            .PostgresqlDatabase(connectionString)
            .WithScriptsEmbeddedInAssembly(typeof(DatabaseMigrator).Assembly,
                name => name.EndsWith(".sql", StringComparison.OrdinalIgnoreCase)
                        && name.Contains(".Database.Migrations.", StringComparison.Ordinal))
            .WithTransactionPerScript()
            .LogTo(new MicrosoftUpgradeLog(log))
            .Build();

        var result = upgrader.PerformUpgrade();

        if (!result.Successful)
            throw new InvalidOperationException("Database migration failed.", result.Error);
    }

    private sealed class MicrosoftUpgradeLog(ILogger log) : IUpgradeLog
    {
        public void LogTrace(string format, params object[] args) => log.LogTrace(format, args);

        public void LogDebug(string format, params object[] args) => log.LogDebug(format, args);

        public void LogInformation(string format, params object[] args) => log.LogInformation(format, args);

        public void LogWarning(string format, params object[] args) => log.LogWarning(format, args);

        public void LogError(string format, params object[] args) => log.LogError(format, args);

        public void LogError(Exception ex, string format, params object[] args) => log.LogError(ex, format, args);
    }
}
