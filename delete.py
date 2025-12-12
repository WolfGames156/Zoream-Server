import redis
import sys

# Redis Bağlantısı
try:
    r = redis.Redis(
        host='redis-14889.c277.us-east-1-3.ec2.cloud.redislabs.com',
        port=14889,
        password='cGySKpNCAFjUV8Ywf39u15Lac1byV8YR',
        username='default',
        decode_responses=True
    )
    r.ping()
    print("✅ Redis bağlantısı başarılı.\n")
except Exception as e:
    print(f"❌ Redis bağlantı hatası: {e}")
    sys.exit(1)

def print_menu():
    print("-" * 50)
    print(" ZOREAM REDIS TEMİZLEME ARACI")
    print("-" * 50)
    print("Lütfen silmek istediğiniz veriyi seçin:")
    print("1. Aktif Kullanıcılar (active_ips_v1)")
    print("   -> Sitede şu an online olan kullanıcıların listesini sıfırlar.")
    
    print("2. Oyun Kütüphanesi (games_v1)")
    print("   -> Eklenen tüm oyunları veritabanından siler.")
    
    print("3. Reddedilen Oyunlar (rejected_v1)")
    print("   -> Reddedilen oyunların listesini temizler.")
    
    print("4. Yasaklı IP'ler (banned_ips_v1)")
    print("   -> Banlanan kullanıcıların banını kaldırır (listeyi siler).")
    
    print("5. Kullanıcı Geçmişi/Görülenler (seen_v1)")
    print("   -> Geçmişte siteye giren kullanıcıların (User Activity) kaydını siler.")
    
    print("6. Oyun İsimleri Önbelleği (names_v1)")
    print("   -> Steam API'den çekilen oyun isimlerini temizler.")
    
    print("7. Çıkış")
    print("-" * 50)

keys_map = {
    "1": ("active_ips_v1", "Aktif Kullanıcılar"),
    "2": ("games_v1", "Oyun Kütüphanesi"),
    "3": ("rejected_v1", "Reddedilen Oyunlar"),
    "4": ("banned_ips_v1", "Yasaklı IP'ler"),
    "5": ("seen_v1", "Kullanıcı Geçmişi"),
    "6": ("names_v1", "Oyun İsimleri Önbelleği")
}

while True:
    print_menu()
    choice = input("Seçiminiz (1-7): ").strip()

    if choice == "7":
        print("Çıkış yapılıyor...")
        break

    if choice in keys_map:
        key, label = keys_map[choice]
        
        # Onay isteme
        confirm = input(f"❗ DİKKAT: '{label}' ({key}) verisini silmek üzeresiniz. Emin misiniz? (e/h): ").lower()
        
        if confirm == 'e':
            result = r.delete(key)
            if result > 0:
                print(f"\n✅ {label} başarıyla silindi. (Silinen anahtar sayısı: {result})")
            else:
                print(f"\n⚠️ {label} zaten boş veya bulunamadı.")
        else:
            print("\n❌ İşlem iptal edildi.")
    else:
        print("\n❌ Geçersiz seçim, lütfen tekrar deneyin.")
    
    print("\n" + "="*50 + "\n")
