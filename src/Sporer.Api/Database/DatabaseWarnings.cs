namespace Sporer.Api.Database;

/// <summary>Human-readable warnings found while inspecting the database at startup.</summary>
public sealed class DatabaseWarnings
{
    private readonly List<string> _items = [];

    public IReadOnlyList<string> Items => _items;

    public void Add(string warning) => _items.Add(warning);
}
