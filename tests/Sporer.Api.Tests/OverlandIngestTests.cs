using System.Net;
using System.Text;

namespace Sporer.Api.Tests;

[Collection("db")]
public class OverlandIngestTests(DatabaseFixture db)
{
    // The table exactly as src/Sporer.Api/DB/01-Create-table.sql creates it today.
    private const string OldCreateTableScript = """
        CREATE EXTENSION if not exists timescaledb;

        CREATE TABLE locationLog (
            time      TIMESTAMPTZ       NOT NULL,
            longitude DOUBLE precision  NOT NULL,
            latitude  DOUBLE PRECISION  NOT NULL,
            device    text              NOT NULL,
            speed     DOUBLE PRECISION  NULL,
            altitude  numeric           NOT NULL
        );

        SELECT create_hypertable('locationLog', by_range('time'));
        """;

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    [Fact]
    public async Task Ingest_stores_point_like_today()
    {
        var cs = await db.CreateDatabaseAsync();
        await Sql.ExecAsync(cs, OldCreateTableScript);
        await using var api = new ApiFactory(cs);
        var res = await api.CreateClient().PostAsync("/api/overland", Json(Payload.One(
            time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: -1, altitude: 12, device: "phone")),
            TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await res.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var row = await Sql.SingleAsync(cs, "select time, longitude, latitude, device, speed, altitude from locationlog");
        Assert.Equal(new DateTime(2026,10,22,7,0,0,DateTimeKind.Utc), row.time);
        Assert.Equal((10.75, 59.91, "phone"), ((double)row.longitude, (double)row.latitude, (string)row.device));
        Assert.Null(row.speed);
        Assert.Equal(12m, row.altitude);
    }
}
